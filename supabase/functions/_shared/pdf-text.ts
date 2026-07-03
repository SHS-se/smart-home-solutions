export function wrapTextByWidth(
  text: string,
  maxWidth: number,
  measureText: (value: string) => number,
): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [""];

  const lines: string[] = [];
  let currentLine = "";

  const pushLongWord = (word: string) => {
    let currentPart = "";
    for (const char of word) {
      const candidate = `${currentPart}${char}`;
      if (!currentPart || measureText(candidate) <= maxWidth) {
        currentPart = candidate;
        continue;
      }
      lines.push(currentPart);
      currentPart = char;
    }
    currentLine = currentPart;
  };

  for (const word of normalized.split(" ")) {
    const candidate = currentLine ? `${currentLine} ${word}` : word;
    if (measureText(candidate) <= maxWidth) {
      currentLine = candidate;
      continue;
    }

    if (currentLine) {
      lines.push(currentLine);
      currentLine = "";
    }

    if (measureText(word) <= maxWidth) {
      currentLine = word;
    } else {
      pushLongWord(word);
    }
  }

  if (currentLine) lines.push(currentLine);
  return lines;
}
