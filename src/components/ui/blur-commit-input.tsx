import React, { useState, useEffect, useRef } from 'react';
import { Input } from '@/components/ui/input';

interface BlurCommitInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'> {
  value: string | number;
  onCommit: (value: string) => void;
}

/**
 * An input that uses local state while typing and only commits
 * the value when the user leaves the field (onBlur) or presses Enter.
 * 
 * For number inputs: Arrow button clicks and keyboard arrow keys
 * commit immediately for responsive feedback.
 */
const BlurCommitInput = React.forwardRef<HTMLInputElement, BlurCommitInputProps>(
  ({ value, onCommit, type, ...props }, ref) => {
    const [localValue, setLocalValue] = useState(String(value));
    const isSpinnerClickRef = useRef(false);

    // Sync local state when external value changes
    useEffect(() => {
      setLocalValue(String(value));
    }, [value]);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = e.target.value;
      setLocalValue(newValue);

      // For number inputs: if this change came from spinner buttons, commit immediately
      if (type === 'number' && isSpinnerClickRef.current) {
        isSpinnerClickRef.current = false;
        if (newValue !== String(value)) {
          onCommit(newValue);
        }
      }
    };

    const handleCommit = () => {
      // Only commit if value actually changed
      if (localValue !== String(value)) {
        onCommit(localValue);
      }
    };

    const handleMouseDown = (e: React.MouseEvent<HTMLInputElement>) => {
      // For number inputs: detect if the click is on the spinner buttons (right side)
      if (type === 'number') {
        const input = e.currentTarget;
        const rect = input.getBoundingClientRect();
        const spinnerWidth = 30; // Approximate width of spinner buttons

        if (e.clientX > rect.right - spinnerWidth) {
          isSpinnerClickRef.current = true;
        }
      }
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
      // For number inputs: arrow keys should commit immediately
      if (type === 'number' && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        isSpinnerClickRef.current = true;
      }
      if (e.key === 'Enter') {
        e.currentTarget.blur();
      }
    };

    return (
      <Input
        ref={ref}
        type={type}
        value={localValue}
        onChange={handleChange}
        onBlur={handleCommit}
        onMouseDown={handleMouseDown}
        onKeyDown={handleKeyDown}
        {...props}
      />
    );
  }
);

BlurCommitInput.displayName = 'BlurCommitInput';

export default BlurCommitInput;
