import React from 'react';
import { Deployment } from '../../types';

const ACTIVE = ['queued', 'sent', 'downloading', 'installing', 'uninstalling'];

export const isActiveDeployment = (d?: Deployment | null) => !!d && ACTIVE.includes(d.status);

/** 배포 상태 배지 (+ 다운로드 진행률 막대) */
export const DeploymentBadge: React.FC<{ d: Deployment | null }> = ({ d }) => {
  if (!d) return <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>-</span>;
  const cls =
    d.status === 'success'
      ? 'badge-ok'
      : d.status === 'failed' || d.status === 'rejected'
        ? 'badge-danger'
        : d.status === 'cancelled'
          ? ''
          : 'badge-warn';
  const verb = d.action === 'install' ? '설치' : '삭제';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 140 }}>
      <span className={`badge ${cls}`} style={{ alignSelf: 'flex-start' }}>
        {verb} · {d.status_label}
        {d.status === 'downloading' ? ` ${d.progress}%` : ''}
      </span>
      {d.status === 'downloading' && (
        <div style={{ height: 4, borderRadius: 2, background: 'var(--border-subtle)', overflow: 'hidden' }}>
          <div style={{ width: `${d.progress}%`, height: '100%', background: 'var(--accent-primary)' }} />
        </div>
      )}
    </div>
  );
};
