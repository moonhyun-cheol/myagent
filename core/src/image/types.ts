export interface ImageGenRequest {
  prompt: string;
  negative_prompt?: string;
  width?: number;
  height?: number;
  sessionId: string;
  initImagePath?: string;
}

export interface ImageGenResult {
  output_path: string;
  url: string;
  mime: 'image/png';
  backend_used: string;
  seed: number;
  stub: boolean;
}

export interface IImageBackend {
  name: string;
  generate(req: ImageGenRequest, outputPath: string): Promise<ImageGenResult>;
  isAvailable(): boolean;
}
