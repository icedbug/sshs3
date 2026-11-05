// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { TagInput } from '../../src/renderer/src/components/ui/TagInput';
import { TagChips } from '../../src/renderer/src/components/ui/TagChips';
import { ProfileOrganizationFields } from '../../src/renderer/src/components/ConnectionModal/ProfileOrganizationFields';

afterEach(cleanup);

const type = (input: HTMLElement, text: string) => fireEvent.change(input, { target: { value: text } });

describe('TagInput', () => {
  it('adds the typed tag on Enter and clears the field', () => {
    const onChange = vi.fn();
    render(<TagInput id="t" value={[]} onChange={onChange} />);
    const input = screen.getByRole('textbox');
    type(input, '#Prod');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(['Prod']);
    expect(input).toHaveValue('');
  });

  it('adds several comma-separated tags at once, sorted and deduped against the existing ones', () => {
    const onChange = vi.fn();
    render(<TagInput value={['web']} onChange={onChange} />);
    const input = screen.getByRole('textbox');
    type(input, 'db, WEB, api');
    fireEvent.keyDown(input, { key: ',' });
    expect(onChange).toHaveBeenCalledWith(['api', 'db', 'web']);
  });

  it('lets Enter on an empty field through, so the surrounding form can still submit', () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <TagInput value={[]} onChange={vi.fn()} />
        <button type="submit">Save</button>
      </form>
    );
    const input = screen.getByRole('textbox');
    const notPrevented = fireEvent.keyDown(input, { key: 'Enter' });
    expect(notPrevented).toBe(true);
  });

  it('keeps Enter from submitting the form while a tag is being typed', () => {
    render(<TagInput value={[]} onChange={vi.fn()} />);
    const input = screen.getByRole('textbox');
    type(input, 'prod');
    expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(false);
  });

  it('removes the last tag on Backspace in the empty field and any tag via its button', () => {
    const onChange = vi.fn();
    render(<TagInput value={['a', 'b']} onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Backspace' });
    expect(onChange).toHaveBeenLastCalledWith(['a']);
    fireEvent.click(screen.getByRole('button', { name: 'Remove tag a' }));
    expect(onChange).toHaveBeenLastCalledWith(['b']);
  });

  it('rejects an invalid tag, keeps the text and explains why', () => {
    const onChange = vi.fn();
    render(<TagInput value={[]} onChange={onChange} />);
    const input = screen.getByRole('textbox');
    type(input, 'two words');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
    expect(input).toHaveValue('two words');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent(/no spaces/);
  });

  it('adds text still in the field on blur, so Save does not lose it', () => {
    const onChange = vi.fn();
    render(<TagInput value={[]} onChange={onChange} />);
    const input = screen.getByRole('textbox');
    type(input, 'db');
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith(['db']);
  });

  it('offers only suggestions that are not already on the profile', () => {
    const { container } = render(<TagInput value={['prod']} onChange={vi.fn()} suggestions={['Prod', 'db']} />);
    const options = Array.from(container.querySelectorAll('datalist option')).map((o) => o.getAttribute('value'));
    expect(options).toEqual(['db']);
  });

  it('stops accepting input at the tag limit and hides remove buttons when disabled', () => {
    const many = Array.from({ length: 10 }, (_, i) => `t${i}`);
    const { rerender } = render(<TagInput value={many} onChange={vi.fn()} />);
    expect(screen.getByRole('textbox')).toBeDisabled();
    rerender(<TagInput value={['a']} onChange={vi.fn()} disabled />);
    expect(screen.queryByRole('button', { name: /Remove tag/ })).toBeNull();
  });
});

describe('TagChips', () => {
  it('renders nothing without tags', () => {
    const { container } = render(<TagChips tags={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('collapses the tags beyond the limit into +N and keeps all of them in the tooltip', () => {
    render(<TagChips tags={['a', 'b', 'c', 'd', 'e']} max={3} />);
    const chips = screen.getByTestId('tag-chips');
    expect(chips).toHaveTextContent('+2');
    expect(chips).toHaveAttribute('title', 'a, b, c, d, e');
  });
});

describe('ProfileOrganizationFields', () => {
  it('edits group and tags through the callbacks and labels both fields', () => {
    const onGroupChange = vi.fn();
    const onTagsChange = vi.fn();
    render(
      <ProfileOrganizationFields
        group="Work"
        tags={['prod']}
        onGroupChange={onGroupChange}
        onTagsChange={onTagsChange}
        groupPlaceholder="e.g. Production"
      />
    );
    fireEvent.change(screen.getByLabelText(/Group \/ Folder/), { target: { value: 'Home' } });
    expect(onGroupChange).toHaveBeenCalledWith('Home');

    fireEvent.click(screen.getByRole('button', { name: 'Remove tag prod' }));
    expect(onTagsChange).toHaveBeenCalledWith(undefined);

    const tagsField = screen.getByLabelText('Tags (optional)');
    fireEvent.change(tagsField, { target: { value: 'db' } });
    fireEvent.keyDown(tagsField, { key: 'Enter' });
    expect(onTagsChange).toHaveBeenLastCalledWith(['db', 'prod']);
  });

  it('uses the Team Vault folder suggestions and their placeholder when given', () => {
    render(
      <ProfileOrganizationFields
        group={undefined}
        tags={undefined}
        onGroupChange={vi.fn()}
        onTagsChange={vi.fn()}
        groupPlaceholder="e.g. Production"
        folderSuggestions={['Acme Infra/Cluster A']}
      />
    );
    expect(screen.getByPlaceholderText('e.g. Acme Infra/Cluster A')).toBeInTheDocument();
  });
});
