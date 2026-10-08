export function rawSourceWorkerCommand(
  inputPath: string,
  outputPath: string,
  env?: NodeJS.ProcessEnv,
): { command: string; args: string[] }
