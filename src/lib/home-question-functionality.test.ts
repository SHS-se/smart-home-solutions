import { HOME_QUESTION_FUNCTIONALITY } from './home-question-functionality.ts';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test('functional home-question bindings are unique and include move-in date', () => {
  const keys = HOME_QUESTION_FUNCTIONALITY.map((definition) => definition.key);
  assert(new Set(keys).size === keys.length, 'functionality keys must be unique');

  const moveIn = HOME_QUESTION_FUNCTIONALITY.find((definition) => (
    definition.key === 'move_in_date'
  ));
  assert(moveIn?.type === 'date', 'move-in binding must require a date answer');
  assert(moveIn?.dataUse === 'calculation', 'move-in date must be marked as actively used');
});

Deno.test('setup-only fields are not presented as current simulator calculations', () => {
  const setupOnly = HOME_QUESTION_FUNCTIONALITY.filter((definition) => (
    definition.dataUse === 'setup_only'
  ));
  assert(setupOnly.length > 0, 'catalog should expose future simulator inputs');
  assert(
    setupOnly.every((definition) => definition.features.includes('energy_setup')),
    'setup-only fields must be labelled as energy setup rather than active simulation',
  );
});
