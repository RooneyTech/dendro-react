import * as React from 'react';

export function EditableDraft({ value }: { value: string }) {
  const [draft, setDraft] = React.useState(value);
  React.useEffect(() => {
    setDraft(value);
  }, [value]);
  // The user can change draft independently; deriving it from value would
  // erase in-progress input. The effect resets it on external value changes.
  return <input value={draft} onChange={event => setDraft(event.target.value)} />;
}
