import { spawn } from 'node:child_process'

export function spawnTestProcess(args: string[], options: { stdout: 'pipe'; stderr: 'pipe' }) {
  const child = spawn(args[0], ['--import', 'tsx', ...args.slice(1)], { stdio: ['ignore', options.stdout, options.stderr] })
  return {
    stdout: readOutput(child.stdout),
    stderr: readOutput(child.stderr),
    exited: new Promise<number>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code) => resolve(code ?? 1))
    }),
  }
}

async function readOutput(stream: AsyncIterable<Buffer>): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}
