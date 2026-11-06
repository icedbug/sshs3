import React from 'react';
import BaseSettingsModal from './SettingsModal/SettingsModal';

export const SettingsModal: React.FC<React.ComponentProps<typeof BaseSettingsModal>> = (props) => (
  <BaseSettingsModal {...props} />
);

export default SettingsModal;
