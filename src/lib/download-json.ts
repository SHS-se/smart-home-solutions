/** Hand the browser a JSON file to save, pretty-printed so it can be read as well as parsed. */
export function downloadJson(filename: string, data: unknown): void {
  const url = URL.createObjectURL(new Blob(
    [`${JSON.stringify(data, null, 2)}\n`],
    { type: 'application/json;charset=utf-8' },
  ));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
