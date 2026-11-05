import React, { useId } from 'react';
import { TagInput } from '../ui/TagInput';

interface ProfileOrganizationFieldsProps {
  group: string | undefined;
  tags: string[] | undefined;
  onGroupChange: (group: string) => void;
  onTagsChange: (tags: string[] | undefined) => void;
  groupPlaceholder: string;
  /** Existing Team Vault folder paths for the Group/Folder autocomplete (see `SSHProfileFormProps.folderSuggestions`). */
  folderSuggestions?: string[];
  /** Tags already in use on other profiles, offered while typing. */
  tagSuggestions?: string[];
  /** The folder belongs to the profile's system, so it is shown but not edited here (move the system instead). */
  groupFollowsSystem?: boolean;
}

/**
 * The "where does this profile live" fields shared by the SSH and S3 forms: Group/Folder and Tags.
 * Renders two grid items (the parent is the two-column grid next to Profile Name); Tags spans both.
 */
export const ProfileOrganizationFields: React.FC<ProfileOrganizationFieldsProps> = ({
  group,
  tags,
  onGroupChange,
  onTagsChange,
  groupPlaceholder,
  folderSuggestions,
  tagSuggestions,
  groupFollowsSystem = false,
}) => {
  const baseId = useId();
  const folderListId = `${baseId}-folders`;
  const tagsId = `${baseId}-tags`;
  return (
    <>
      <label className="flex flex-col gap-1 text-txt-secondary">
        Group / Folder (optional)
        <input
          value={group ?? ''}
          onChange={(e) => onGroupChange(e.target.value)}
          readOnly={groupFollowsSystem}
          title={groupFollowsSystem ? 'The folder follows the system. Move the system to change it.' : undefined}
          list={folderSuggestions && !groupFollowsSystem ? folderListId : undefined}
          className={`rounded-lg border border-border-subtle bg-app-input px-2.5 py-1.5 text-sm text-txt-primary outline-none focus:border-sky-500 placeholder-txt-muted ${
            groupFollowsSystem ? 'cursor-not-allowed opacity-60' : ''
          }`}
          placeholder={folderSuggestions ? 'e.g. Acme Infra/Cluster A' : groupPlaceholder}
        />
        {groupFollowsSystem && <span className="text-xs text-txt-muted">Follows the system</span>}
        {folderSuggestions && !groupFollowsSystem && (
          <datalist id={folderListId}>
            {folderSuggestions.map((path) => (
              <option key={path} value={path} />
            ))}
          </datalist>
        )}
      </label>
      <div className="col-span-2 flex flex-col gap-1 text-txt-secondary">
        <label htmlFor={tagsId}>Tags (optional)</label>
        <TagInput
          id={tagsId}
          value={tags ?? []}
          onChange={(next) => onTagsChange(next.length > 0 ? next : undefined)}
          suggestions={tagSuggestions}
        />
      </div>
    </>
  );
};
