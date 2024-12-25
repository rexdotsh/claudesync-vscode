import { CompressedContent } from "./types";

export class CompressionUtils {
  private static readonly CHUNK_SIZE = 1024 * 64; // 64KB chunks

  public static async compressContent(content: string): Promise<CompressedContent> {
    const encoder = new TextEncoder();
    const originalSize = encoder.encode(content).length;

    // If content is small enough, return as is
    if (originalSize <= this.CHUNK_SIZE) {
      return {
        content,
        originalSize,
        compressedSize: originalSize,
      };
    }

    // Simple compression by removing unnecessary whitespace
    const compressed = content
      .replace(/\s+/g, " ") // Replace multiple spaces with single space
      .replace(/^\s+|\s+$/gm, "") // Remove leading/trailing whitespace
      .replace(/\n\s*\n/g, "\n"); // Replace multiple newlines with single newline

    const compressedSize = encoder.encode(compressed).length;

    return {
      content: compressed,
      originalSize,
      compressedSize,
    };
  }

  public static async splitContentIntoChunks(content: string): Promise<string[]> {
    const encoder = new TextEncoder();
    const chunks: string[] = [];
    let currentChunk = "";

    const lines = content.split("\n");

    for (const line of lines) {
      const potentialChunk = currentChunk + (currentChunk ? "\n" : "") + line;
      if (encoder.encode(potentialChunk).length > this.CHUNK_SIZE && currentChunk) {
        chunks.push(currentChunk);
        currentChunk = line;
      } else {
        currentChunk = potentialChunk;
      }
    }

    if (currentChunk) {
      chunks.push(currentChunk);
    }

    return chunks;
  }

  public static estimateTokenCount(content: string): number {
    // Rough estimation: ~4 characters per token on average
    return Math.ceil(content.length / 4);
  }
}
