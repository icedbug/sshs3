import React from 'react';
import BaseSSHGlobalTunnelsModal from './SSH/SSHGlobalTunnelsModal';

export const SSHGlobalTunnelsModal: React.FC<
  React.ComponentProps<typeof BaseSSHGlobalTunnelsModal>
> = (props) => <BaseSSHGlobalTunnelsModal {...props} />;

export default SSHGlobalTunnelsModal;
