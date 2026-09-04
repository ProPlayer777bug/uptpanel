declare module 'ssh2' {
  export class Client {
    constructor(opts?: any)
    on(event: string, cb: (...args: any[]) => void): this
    connect(opts: { host: string; port?: number; username: string; password?: string; privateKey?: any; tryKeyboard?: boolean }): void
    exec(cmd: string, cb: (err: any, stream: any) => void): void
    sftp(cb: (err: any, sftp: any) => void): void
    end(): void
    shell(cb: (err: any, stream: any) => void): void
  }
}