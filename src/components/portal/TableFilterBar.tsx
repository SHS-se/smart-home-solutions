import React from 'react';
import { Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export interface FilterOption {
  value: string;
  label: string;
}

interface TableFilterBarProps {
  filterValue: string;
  onFilterChange: (value: string) => void;
  filterOptions: FilterOption[];
  searchQuery: string;
  onSearchChange: (value: string) => void;
  searchPlaceholder: string;
}

const TableFilterBar: React.FC<TableFilterBarProps> = ({
  filterValue,
  onFilterChange,
  filterOptions,
  searchQuery,
  onSearchChange,
  searchPlaceholder,
}) => {
  return (
    <div className="flex flex-col sm:flex-row gap-4">
      <Select value={filterValue} onValueChange={onFilterChange}>
        <SelectTrigger className="w-full sm:w-[200px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {filterOptions.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="relative flex-1">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder={searchPlaceholder}
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          className="pl-9"
        />
      </div>
    </div>
  );
};

export default TableFilterBar;
