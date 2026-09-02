export type MyAgentApiConfig = {
  baseUrl: string;
  port: number;
  cqrRoot: string;
};

declare global {
  interface Window {
    __MY_AGENT_API__?: MyAgentApiConfig;
  }
}

export {};
