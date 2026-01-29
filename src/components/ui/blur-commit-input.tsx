import React, { useState, useEffect } from 'react';
import { Input } from '@/components/ui/input';

interface BlurCommitInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'> {
  value: string | number;
  onCommit: (value: string) => void;
}

/**
 * An input that uses local state while typing and only commits
 * the value when the user leaves the field (onBlur) or presses Enter.
 * No mutations are triggered during typing.
 */
const BlurCommitInput = React.forwardRef<HTMLInputElement, BlurCommitInputProps>(
  ({ value, onCommit, type, ...props }, ref) => {
    const [localValue, setLocalValue] = useState(String(value));

    // Sync local state when external value changes
    useEffect(() => {
      setLocalValue(String(value));
    }, [value]);

    const handleCommit = () => {
      // Only commit if value actually changed
      if (localValue !== String(value)) {
        onCommit(localValue);
      }
    };

    return (
      <Input
        ref={ref}
        type={type}
        value={localValue}
        onChange={(e) => setLocalValue(e.target.value)}
        onBlur={handleCommit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.currentTarget.blur();
          }
        }}
        {...props}
      />
    );
  }
);

BlurCommitInput.displayName = 'BlurCommitInput';

export default BlurCommitInput;
