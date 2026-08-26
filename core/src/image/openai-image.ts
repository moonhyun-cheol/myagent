import { writeFileSync } from 'node:fs';
import type { ImageGenRequest, ImageGenResult } from './types.js';
import type { IImageBackend } from './types.js';

export class OpenAiImageBackend implements IImageBackend {
  readonly name = 'openai-dalle';

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model = 'dall-e-3',
  ) {}

  isAvailable(): boolean {
    return Boolean(this.apiKey) && !this.apiKey.startsWith('disabled:');
  }

  async generate(req: ImageGenRequest, outputPath: string): Promise<ImageGenResult> {
    if (this.apiKey.startsWith('stub:')) {
      throw new Error('OPENAI_IMAGE_STUB');
    }

    const url = `${this.baseUrl.replace(/\/$/, '')}/images/generations`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        prompt: req.prompt,
        n: 1,
        size: '1024x1024',
        response_format: 'b64_json',
      }),
      signal: AbortSignal.timeout(120_000),
    });

    const text = await res.text();
    let data: {
      error?: { message?: string };
      data?: { b64_json?: string }[];
    };
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`OPENAI_IMAGE_INVALID (${res.status})`);
    }

    if (!res.ok) {
      throw new Error(data.error?.message ?? `OPENAI_IMAGE_${res.status}`);
    }

    const b64 = data.data?.[0]?.b64_json;
    if (!b64) throw new Error('OPENAI_IMAGE_EMPTY');
    writeFileSync(outputPath, Buffer.from(b64, 'base64'));

    return {
      output_path: outputPath,
      url: '',
      mime: 'image/png',
      backend_used: this.name,
      seed: 0,
      stub: false,
    };
  }
}
