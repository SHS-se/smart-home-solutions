import React, { useState, useEffect } from 'react';
import { Input } from '@/components/ui/input';

interface QuantityInputProps {
  value: number;
  onCommit: (value: number) => void;
  onChange?: (value: number) => void;
  min?: number;
  className?: string;
}

/**
 * A quantity input that uses local state while typing.
 * Only commits when the user leaves the field (blur) or presses Enter.
 * No processing or mutations occur during typing.
 */
const QuantityInput: React.FC<QuantityInputProps> = ({
  value,
  onCommit,
  onChange,
  min = 1,
  className = '',
}) => {
  const [localValue, setLocalValue] = useState(String(value));

  // Sync local state when external value changes
  useEffect(() => {
    setLocalValue(String(value));
  }, [value]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    setLocalValue(newValue);
    
    // Notify parent of the pending change (for flush-before-navigate patterns)
    if (onChange) {
      const parsed = parseInt(newValue, 10);
      if (!isNaN(parsed) && parsed >= min) {
        onChange(parsed);
      }
    }
  };

  const handleCommit = () => {
    const parsed = parseInt(localValue, 10);
    const finalValue = isNaN(parsed) || parsed < min ? min : parsed;
    
    // Only commit if value actually changed
    if (finalValue !== value) {
      onCommit(finalValue);
    }
    setLocalValue(String(finalValue));
  };

  return (
    <Input
      type="number"
      min={min}
      value={localValue}
      onChange={handleChange}
      onBlur={handleCommit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.currentTarget.blur();
        }
      }}
      className={className}
    />
  );
};

export default QuantityInput;
