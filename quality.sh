#!/bin/bash
# Run all code quality checks

echo "🔍 Running code quality checks..."
echo ""

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "1. ESLint - Code linting"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
npm run lint
LINT_EXIT=$?

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "2. JSCPD - Duplicate code detection"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
npm run duplicate
DUPLICATE_EXIT=$?

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Summary"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ $LINT_EXIT -eq 0 ]; then
    echo "✓ ESLint: PASSED"
else
    echo "✗ ESLint: FAILED"
fi

if [ $DUPLICATE_EXIT -eq 0 ]; then
    echo "✓ Duplication: PASSED"
else
    echo "✗ Duplication: FAILED"
fi

echo ""
echo "Reports:"
echo "  Duplication: reports/jscpd/html/index.html"

# Exit with error if any check failed
if [ $LINT_EXIT -ne 0 ] || [ $DUPLICATE_EXIT -ne 0 ]; then
    exit 1
fi
