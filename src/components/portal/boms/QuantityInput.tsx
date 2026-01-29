import React, { useState, useEffect } from 'react';
import { Input } from '@/components/ui/input';

interface QuantityInputProps {
  value: number;
  onCommit: (value: number) => void;
  min?: number;
  className?: string;
}

/**
 * A quantity input that uses local state and only commits changes
 * on blur or Enter key. This prevents database mutations on every keystroke.
 */
const QuantityInput: React.FC<QuantityInputProps> = ({
  value,
  onCommit,
  min = 1,
  className = '',
}) => {
  const [localValue, setLocalValue] = useState(String(value));

  // Sync local state when external value changes (e.g., after mutation succeeds)
  useEffect(() => {
    setLocalValue(String(value));
  }, [value]);

  const handleCommit = () => {
    const parsed = parseInt(localValue, 10);
    const finalValue = isNaN(parsed) || parsed < min ? min : parsed;
    
    // Only commit if value actually changed
    if (finalValue !== value) {
      onCommit(finalValue);
    }
    // Reset to the committed value (in case user typed invalid input)
    setLocalValue(String(finalValue));
  };

  return (
    <Input
      type="number"
      min={min}
      value={localValue}
      onChange={(e) => setLocalValue(e.target.value)}
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
