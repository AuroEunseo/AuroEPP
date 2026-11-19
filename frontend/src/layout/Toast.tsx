import React from 'react';

/** 우측 상단 알림 메시지 */
export const Toast: React.FC<{ message: string | null }> = ({ message }) =>
  message ? (
    <div
      style={{
        position: 'fixed',
        top: 18,
        right: 24,
        zIndex: 9999,
        background: 'var(--accent-primary, #0284c7)',
        color: '#ffffff',
        padding: '10px 18px',
        borderRadius: 8,
        fontWeight: 600,
        fontSize: 13,
        boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
      }}
    >
      {message}
    </div>
  ) : null;
