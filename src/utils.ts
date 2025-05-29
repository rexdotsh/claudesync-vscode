function str2ab(str: string): ArrayBuffer {
  const buf = new ArrayBuffer(str.length);
  const bufView = new Uint8Array(buf);
  for (let i = 0; i < str.length; i++) {
    bufView[i] = str.charCodeAt(i);
  }
  return buf;
}

function ab2hex(buffer: ArrayBuffer): string {
  const hashArray = Array.from(new Uint8Array(buffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function computeSHA256Hash(content: string): Promise<string> {
  const msgBuffer = str2ab(content);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  return ab2hex(hashBuffer);
}
