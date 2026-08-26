import { chatCompletion, type ChatCompletionOptions } from './openai-compatible.js';

export type VisionContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } };

export interface VisionChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | VisionContentPart[];
}

export async function chatCompletionVision(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: VisionChatMessage[],
  opts?: ChatCompletionOptions,
): Promise<{ content: string; model: string }> {
  return chatCompletion(baseUrl, apiKey, model, messages, opts);
}
