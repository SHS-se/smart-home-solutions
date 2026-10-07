/** Credentials for the explicitly authorized, private TEST diagnostic endpoint. */
export const PROBE_PROJECT = 'vxqpgbzseckgceopitpm';
export async function testProbeServiceKey(): Promise<string> {
  const result = await new Deno.Command('supabase', {
    args: ['projects', 'api-keys', '--project-ref', PROBE_PROJECT, '--reveal', '--output', 'json'],
    stdout: 'piped',
    stderr: 'null',
  }).output();
  if (!result.success) throw new Error('Could not read TEST probe credentials.');
  const rows: unknown = JSON.parse(new TextDecoder().decode(result.stdout));
  if (!Array.isArray(rows)) throw new Error('Invalid API-key response.');
  for (const row of rows) {
    if (
      row && typeof row === 'object' && 'name' in row && row.name === 'service_role' &&
      'api_key' in row && typeof row.api_key === 'string' && row.api_key.length
    ) return row.api_key;
  }
  throw new Error('TEST service role key is unavailable.');
}
