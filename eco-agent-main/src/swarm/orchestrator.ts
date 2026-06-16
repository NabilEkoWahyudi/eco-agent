import pLimit from 'p-limit'
import EventEmitter from 'eventemitter3'
import type { Provider } from '../providers/index.js'
import type { Tool } from '../utils/types.js'
import { AgentLoop } from '../loop/index.js'
import type { SwarmTask, SwarmPlan, SwarmResult, WorkerOptions } from './types.js'
import { isReady, summarizeResults } from './planner.js'

export type SwarmEvent =
  | { type: 'task:start';    task: SwarmTask; workerIndex: number }
  | { type: 'task:done';     task: SwarmTask; result: string }
  | { type: 'task:failed';   task: SwarmTask; error: string }
  | { type: 'task:skipped';  task: SwarmTask; reason: string }
  | { type: 'worker:tool';   taskId: string; toolName: string }
  | { type: 'plan:ready';    plan: SwarmPlan }
  | { type: 'swarm:done';    result: SwarmResult }

export class SwarmOrchestrator extends EventEmitter<{ event: [SwarmEvent] }> {
  private provider: Provider
  private tools: Tool[]
  private options: WorkerOptions

  constructor(provider: Provider, tools: Tool[], options: WorkerOptions = {}) {
    super()
    this.provider = provider
    this.tools = tools
    this.options = options
  }

  async run(plan: SwarmPlan): Promise<SwarmResult> {
    const startTime = Date.now()
    const maxWorkers = this.options.maxWorkers ?? 3
    const limit = pLimit(maxWorkers)
    const tasks = [...plan.tasks]

    // Mark all as pending
    tasks.forEach(t => { t.status = 'pending' })

    // Build context from completed tasks for dependent workers
    const getContext = (task: SwarmTask): string => {
      if (!task.dependsOn?.length) return ''
      const depResults = task.dependsOn
        .map(id => tasks.find(t => t.id === id))
        .filter((t): t is SwarmTask => t?.status === 'done' && !!t.result)
        .map(t => `[${t.title}]:\n${t.result}`)
      return depResults.length > 0
        ? `\nResults from prerequisite tasks:\n${depResults.join('\n\n')}\n`
        : ''
    }

    // Wave-based execution: run all ready tasks in parallel, repeat until done
    let wave = 0
    while (tasks.some(t => t.status === 'pending' || t.status === 'running')) {
      wave++

      // Find tasks that are ready to run
      const ready = tasks.filter(t =>
        t.status === 'pending' && isReady(t, tasks)
      )

      // Check for deadlock — pending tasks with failed deps
      const stuck = tasks.filter(t => {
        if (t.status !== 'pending') return false
        return t.dependsOn?.some(id => {
          const dep = tasks.find(d => d.id === id)
          return dep?.status === 'failed' || dep?.status === 'skipped'
        })
      })
      stuck.forEach(t => {
        t.status = 'skipped'
        this.emit('event', { type: 'task:skipped', task: t, reason: 'dependency failed' })
      })

      if (ready.length === 0) break

      // Mark all ready tasks as running
      ready.forEach((t, i) => {
        t.status = 'running'
        t.workerIndex = ((wave - 1) * maxWorkers) + i
        t.startedAt = new Date().toISOString()
        this.emit('event', { type: 'task:start', task: t, workerIndex: t.workerIndex })
      })

      // Run them in parallel (limited by pLimit)
      await Promise.allSettled(
        ready.map(task =>
          limit(() => this.runWorker(task, getContext(task)))
        )
      )
    }

    // Summarize
    const succeeded = tasks.filter(t => t.status === 'done').length
    const failed = tasks.filter(t => t.status === 'failed').length
    const skipped = tasks.filter(t => t.status === 'skipped').length

    let summary = `Completed ${succeeded}/${tasks.length} tasks.`
    if (succeeded > 0) {
      try {
        summary = await summarizeResults(plan.goal, tasks, this.provider)
      } catch { /* use default */ }
    }

    const result: SwarmResult = {
      goal: plan.goal,
      tasks,
      succeeded,
      failed,
      skipped,
      duration: Date.now() - startTime,
      summary
    }

    this.emit('event', { type: 'swarm:done', result })
    return result
  }

  private async runWorker(task: SwarmTask, extraContext: string): Promise<void> {
    const workerSystemPrompt = `You are a focused worker agent. Execute the assigned task precisely.
Use the provided tools to accomplish the task. Be efficient and thorough.
${extraContext ? `\nContext from previous tasks:\n${extraContext}` : ''}

Your task: ${task.description}`

    const workerConfig = {
      provider: { type: 'groq' as const, model: 'llama-3.3-70b-versatile' },
      maxIterations: 6,
      verbose: false,
      systemPrompt: workerSystemPrompt
    }

    const agent = new AgentLoop(this.provider, this.tools, workerConfig)
    let output = ''

    try {
      output = await agent.run(task.description, {
        onContent: (chunk) => { output += chunk },
        onToolCall: (toolName) => {
          this.emit('event', { type: 'worker:tool', taskId: task.id, toolName })
        }
      })

      task.status = 'done'
      task.result = output
      task.completedAt = new Date().toISOString()
      this.emit('event', { type: 'task:done', task, result: output })
    } catch (e) {
      const error = (e as Error).message
      task.status = 'failed'
      task.error = error
      task.completedAt = new Date().toISOString()
      this.emit('event', { type: 'task:failed', task, error })
    }
  }
}
