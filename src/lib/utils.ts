import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Natural sort comparator - sorts strings with embedded numbers correctly.
 * Example: "SHS-2", "SHS-9", "SHS-10" instead of "SHS-10", "SHS-2", "SHS-9"
 * Case-insensitive.
 */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/**
 * Sort an array of objects by a string key using natural sort.
 * @param items Array of objects to sort
 * @param key The key to sort by (must be a string property)
 * @param ascending Sort direction (default: true)
 */
export function naturalSort<T>(
  items: T[],
  key: keyof T,
  ascending: boolean = true
): T[] {
  return [...items].sort((a, b) => {
    const aVal = String(a[key] ?? "");
    const bVal = String(b[key] ?? "");
    const result = naturalCompare(aVal, bVal);
    return ascending ? result : -result;
  });
}
