import type { Provider } from '../providers/index.js'
import type { SwarmPlan, SwarmTask } from './types.js'

function generateId(): string {
  return 't_' + Math.random().toString(36).slice(2, 8)
}

/**
 * Orchestrator: asks the LLM to decompose a goal into a list of tasks,
 * with optional dependencies between them.
 */
export async function planSwarm(
  goal: string,
  provider: Provider,
  context?: string
): Promise<SwarmPlan> {
  const systemPrompt = `You are a task planning AI. Your job is to break down a goal into concrete, executable sub-tasks.

Rules:
- Each task must be specific and independently executable by an AI agent with file/shell tools
- Tasks should be granular (1 focused thing each)
- Identify dependencies: if task B needs task A's output, set dependsOn: ["task_a_id"]
- Maximum 8 tasks per plan
- Return ONLY valid JSON, no markdown, no explanation

JSON format:
{
  "tasks": [
    {
      "id": "t_abc123",
      "title": "Short task title",
      "description": "Detailed instruction for the worker agent to execute this task",
      "dependsOn": []
    }
  ]
}`

  const userPrompt = `Goal: ${goal}
${context ? `\nProject context:\n${context}` : ''}

Break this into concrete sub-tasks. Return JSON only.`

  const response = await provider.complete([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ])

  // Parse JSON response
  let parsed: { tasks: Array<{ id?: string; title: string; description: string; dependsOn?: string[] }> }

  try {
    const clean = response.content
      .replace(/```json/gi, '')
      .replace(/```/g, '')
      .trim()
    parsed = JSON.parse(clean) as typeof parsed
  } catch {
    // Fallback: single task with the full goal
    parsed = {
      tasks: [{
        title: 'Execute goal',
        description: goal,
        dependsOn: []
      }]
    }
  }

  const tasks: SwarmTask[] = parsed.tasks.map(t => ({
    id: t.id ?? generateId(),
    title: t.title,
    description: t.description,
    dependsOn: t.dependsOn ?? [],
    status: 'pending' as const
  }))

  return {
    goal,
    tasks,
    createdAt: new Date().toISOString()
  }
}

/**
 * Check if a task's dependencies are all completed
 */
export function isReady(task: SwarmTask, allTasks: SwarmTask[]): boolean {
  if (!task.dependsOn || task.dependsOn.length === 0) return true
  return task.dependsOn.every(depId => {
    const dep = allTasks.find(t => t.id === depId)
    return dep?.status === 'done'
  })
}

/**
 * Summarize swarm results using LLM
 */
export async function summarizeResults(
  goal: string,
  tasks: SwarmTask[],
  provider: Provider
): Promise<string> {
  const taskSummary = tasks.map(t =>
    `[${t.status.toUpperCase()}] ${t.title}\n${t.result ? t.result.slice(0, 300) : t.error ?? ''}`
  ).join('\n\n')

  const response = await provider.complete([
    {
      role: 'system',
      content: 'You are a helpful assistant. Summarize the results of a multi-agent task execution concisely.'
    },
    {
      role: 'user',
      content: `Goal: ${goal}\n\nTask results:\n${taskSummary}\n\nWrite a brief summary of what was accomplished.`
    }
  ])

  return response.content
}
