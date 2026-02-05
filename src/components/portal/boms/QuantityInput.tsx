import React, { useState, useEffect, useRef } from 'react';
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
 * - Arrow button clicks commit immediately
 * - Keyboard typing only commits on blur or Enter
 */
const QuantityInput: React.FC<QuantityInputProps> = ({
  value,
  onCommit,
  onChange,
  min = 1,
  className = '',
}) => {
  const [localValue, setLocalValue] = useState(String(value));
  const isSpinnerClickRef = useRef(false);

  // Sync local state when external value changes
  useEffect(() => {
    setLocalValue(String(value));
  }, [value]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    setLocalValue(newValue);
    
    const parsed = parseInt(newValue, 10);
    const finalValue = isNaN(parsed) || parsed < min ? min : parsed;
    
    // If this change came from spinner buttons, commit immediately
    if (isSpinnerClickRef.current) {
      isSpinnerClickRef.current = false;
      if (finalValue !== value) {
        onCommit(finalValue);
      }
      return;
    }
    
    // Notify parent of the pending change (for flush-before-navigate patterns)
    if (onChange && !isNaN(parsed) && parsed >= min) {
      onChange(parsed);
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

  const handleMouseDown = (e: React.MouseEvent<HTMLInputElement>) => {
    // Detect if the click is on the spinner buttons (right side of input)
    const input = e.currentTarget;
    const rect = input.getBoundingClientRect();
    const spinnerWidth = 30; // Approximate width of spinner buttons
    
    if (e.clientX > rect.right - spinnerWidth) {
      isSpinnerClickRef.current = true;
    }
  };

  return (
    <Input
      type="number"
      min={min}
      value={localValue}
      onChange={handleChange}
      onBlur={handleCommit}
      onMouseDown={handleMouseDown}
      onKeyDown={(e) => {
        // Arrow keys from keyboard should also commit immediately
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          isSpinnerClickRef.current = true;
        }
        if (e.key === 'Enter') {
          e.currentTarget.blur();
        }
      }}
      className={className}
    />
  );
};

export default QuantityInput;
