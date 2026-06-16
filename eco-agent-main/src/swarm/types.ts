export type TaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export interface SwarmTask {
  id: string
  title: string
  description: string
  dependsOn?: string[]   // task IDs that must complete first
  status: TaskStatus
  result?: string
  error?: string
  startedAt?: string
  completedAt?: string
  workerIndex?: number
}

export interface SwarmPlan {
  goal: string
  tasks: SwarmTask[]
  createdAt: string
}

export interface SwarmResult {
  goal: string
  tasks: SwarmTask[]
  succeeded: number
  failed: number
  skipped: number
  duration: number      // ms
  summary: string
}

export interface WorkerOptions {
  maxWorkers?: number   // max parallel agents (default: 3)
  verbose?: boolean     // show each worker's thinking
}
