declare module "tmi.js" {
  type Userstate = {
    "display-name"?: string;
    username?: string;
    emotes?: Record<string, unknown> | null;
    badges?: Record<string, string> | null;
  };

  class Client {
    constructor(options: { channels: string[] });
    on(event: "message", listener: (channel: string, tags: Userstate, message: string, self: boolean) => void): this;
    connect(): Promise<unknown>;
  }

  const tmi: { Client: typeof Client };
  export default tmi;
}
