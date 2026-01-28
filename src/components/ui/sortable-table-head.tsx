import * as React from 'react';
import { ArrowUp, ArrowDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { TableHead } from '@/components/ui/table';
import type { SortDirection } from '@/hooks/use-table-sort';

interface SortableTableHeadProps<T extends string>
  extends React.ThHTMLAttributes<HTMLTableCellElement> {
  column: T;
  currentColumn: T;
  currentDirection: SortDirection;
  onSort: (column: T) => void;
  children: React.ReactNode;
}

export function SortableTableHead<T extends string>({
  column,
  currentColumn,
  currentDirection,
  onSort,
  children,
  className,
  ...props
}: SortableTableHeadProps<T>) {
  const isActive = currentColumn === column;

  return (
    <TableHead
      className={cn(
        'text-muted-foreground text-xs uppercase cursor-pointer select-none hover:bg-muted/50 transition-colors',
        className
      )}
      onClick={() => onSort(column)}
      {...props}
    >
      <div
        className={cn(
          'flex items-center gap-1',
          className?.includes('text-right') && 'justify-end',
          className?.includes('text-center') && 'justify-center'
        )}
      >
        {children}
        {isActive &&
          (currentDirection === 'asc' ? (
            <ArrowUp className="h-3 w-3" />
          ) : (
            <ArrowDown className="h-3 w-3" />
          ))}
      </div>
    </TableHead>
  );
}
