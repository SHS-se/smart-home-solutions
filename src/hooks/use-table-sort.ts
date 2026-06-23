import { useState, useMemo, useCallback } from 'react';
import { naturalCompare } from '@/lib/utils';

export type SortDirection = 'asc' | 'desc';

export interface SortState<T extends string> {
  column: T;
  direction: SortDirection;
}

export interface UseTableSortOptions<T extends string> {
  defaultColumn: T;
  defaultDirection?: SortDirection;
}

export function useTableSort<T extends string>(options: UseTableSortOptions<T>) {
  const [sortState, setSortState] = useState<SortState<T>>({
    column: options.defaultColumn,
    direction: options.defaultDirection ?? 'asc',
  });

  const handleSort = useCallback((column: T) => {
    setSortState((prev) => {
      if (prev.column === column) {
        return { column, direction: prev.direction === 'asc' ? 'desc' : 'asc' };
      }
      return { column, direction: 'asc' };
    });
  }, []);

  return {
    sortColumn: sortState.column,
    sortDirection: sortState.direction,
    handleSort,
  };
}

/**
 * Generic sort function that handles different value types
 */
export function sortItems<T>(
  items: T[],
  column: keyof T,
  direction: SortDirection,
  options?: {
    getValue?: (item: T) => string | number | Date | null | undefined;
  }
): T[] {
  const getValue = options?.getValue;

  return [...items].sort((a, b) => {
    const aVal = getValue ? getValue(a) : a[column];
    const bVal = getValue ? getValue(b) : b[column];

    // Handle null/undefined
    if (aVal == null && bVal == null) return 0;
    if (aVal == null) return direction === 'asc' ? 1 : -1;
    if (bVal == null) return direction === 'asc' ? -1 : 1;

    // Handle dates
    if (aVal instanceof Date && bVal instanceof Date) {
      const result = aVal.getTime() - bVal.getTime();
      return direction === 'asc' ? result : -result;
    }

    // Handle numbers
    if (typeof aVal === 'number' && typeof bVal === 'number') {
      const result = aVal - bVal;
      return direction === 'asc' ? result : -result;
    }

    // Handle strings with natural sort
    const aStr = String(aVal);
    const bStr = String(bVal);
    const result = naturalCompare(aStr, bStr);
    return direction === 'asc' ? result : -result;
  });
}
