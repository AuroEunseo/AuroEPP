import React, { useEffect, useState } from 'react';
import { getSessionToken } from '../../api';

// `${id}:${rev}` → object URL ('' = 아이콘 없음/불러오기 실패). 같은 아이콘은 한 번만 받는다.
const cache = new Map<string, Promise<string>>();

function loadIcon(id: number, rev: number): Promise<string> {
  const key = `${id}:${rev}`;
  let p = cache.get(key);
  if (!p) {
    p = fetch(`/api/packages/${id}/icon`, { headers: { 'X-Session-Token': getSessionToken() } })
      .then(async (res) => (res.ok ? URL.createObjectURL(await res.blob()) : ''))
      .catch(() => '');
    cache.set(key, p);
  }
  return p;
}

interface Props {
  id: number;
  name: string;
  hasIcon: boolean;
  rev: number;
  size?: number;
  /** 새로 고른 파일 미리보기 (등록·수정 폼) */
  previewUrl?: string;
}

/** 프로그램 아이콘 (없으면 이름 첫 글자) */
export const PackageIcon: React.FC<Props> = ({ id, name, hasIcon, rev, size = 32, previewUrl }) => {
  const [url, setUrl] = useState('');
  useEffect(() => {
    let alive = true;
    setUrl('');
    if (hasIcon && !previewUrl && id > 0) loadIcon(id, rev).then((u) => alive && setUrl(u));
    return () => {
      alive = false;
    };
  }, [id, rev, hasIcon, previewUrl]);

  const src = previewUrl || url;
  const box: React.CSSProperties = {
    width: size,
    height: size,
    flex: `0 0 ${size}px`,
    borderRadius: Math.round(size / 4.5),
    background: 'var(--bg-subcard)',
    border: '1px solid var(--border-subtle)',
  };
  if (src) return <img src={src} alt="" style={{ ...box, objectFit: 'contain', padding: 3 }} />;
  return (
    <div
      style={{
        ...box,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontWeight: 700,
        fontSize: Math.round(size * 0.45),
        color: 'var(--accent-text)',
      }}
    >
      {(name || '?').trim().charAt(0).toUpperCase()}
    </div>
  );
};
