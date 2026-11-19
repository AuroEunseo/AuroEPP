import React, { useState } from 'react';
import { SoftwarePackage } from '../../types';

/** 프로그램 등록/수정 입력값 */
export interface PackageMeta {
  name: string;
  version: string;
  publisher: string;
  install_args: string;
  uninstall_cmd: string;
  detect_name: string;
  timeout_min: number;
  notes: string;
}

/** EXE 무인 설치 옵션 예시 (설치 프로그램 제작 도구별) */
export const EXE_PRESETS = [
  { label: 'NSIS', args: '/S' },
  { label: 'Inno Setup', args: '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP-' },
  { label: 'InstallShield', args: '/s /v"/qn /norestart"' },
  { label: 'MSI 래퍼·일반', args: '/quiet /norestart' },
];

export function metaFromPackage(p: SoftwarePackage): PackageMeta {
  return {
    name: p.name, version: p.version, publisher: p.publisher, install_args: p.install_args,
    uninstall_cmd: p.uninstall_cmd, detect_name: p.detect_name, timeout_min: p.timeout_min, notes: p.notes,
  };
}

export function metaFromFilename(filename: string): PackageMeta {
  const base = filename.replace(/\.(msi|exe)$/i, '');
  const ver = base.match(/(\d+(?:\.\d+){1,3})/)?.[1] || '';
  const name = base.replace(ver, '').replace(/[-_ ]+(setup|installer|x64|x86|win64|win32)?[-_ ]*$/i, '').replace(/[-_]+/g, ' ').trim() || base;
  return { name, version: ver, publisher: '', install_args: '', uninstall_cmd: '', detect_name: name, timeout_min: 30, notes: '' };
}

interface Props {
  kind: 'msi' | 'exe';
  initial: PackageMeta;
  submitLabel: string;
  busy?: boolean;
  onSubmit: (meta: PackageMeta) => void;
  onCancel: () => void;
}

const label: React.CSSProperties = { display: 'block', fontSize: 12, marginBottom: 4, color: 'var(--text-secondary)' };
const hint: React.CSSProperties = { fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.45 };

/** 프로그램 이름·버전·무인 설치 옵션 입력 폼 (등록·수정 공용) */
export const PackageForm: React.FC<Props> = ({ kind, initial, submitLabel, busy, onSubmit, onCancel }) => {
  const [m, setM] = useState<PackageMeta>(initial);
  const set = (k: keyof PackageMeta, v: string | number) => setM((prev) => ({ ...prev, [k]: v }));

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(m);
      }}
      style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}
    >
      <div>
        <label style={label}>프로그램 이름 *</label>
        <input className="input-dark" style={{ width: '100%' }} value={m.name} onChange={(e) => set('name', e.target.value)} />
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <label style={label}>버전</label>
          <input className="input-dark" style={{ width: '100%' }} value={m.version} onChange={(e) => set('version', e.target.value)} />
        </div>
        <div style={{ flex: 1 }}>
          <label style={label}>게시자</label>
          <input className="input-dark" style={{ width: '100%' }} value={m.publisher} onChange={(e) => set('publisher', e.target.value)} />
        </div>
      </div>

      <div style={{ gridColumn: '1 / -1' }}>
        <label style={label}>{kind === 'msi' ? '추가 설치 속성 (선택)' : '무인 설치 옵션 *'}</label>
        <input
          className="input-dark mono"
          style={{ width: '100%' }}
          value={m.install_args}
          onChange={(e) => set('install_args', e.target.value)}
          placeholder={kind === 'msi' ? '예: ALLUSERS=1 INSTALLDIR="C:\\Program Files\\App"' : '예: /S'}
        />
        {kind === 'msi' ? (
          <div style={hint}>MSI 는 <span className="mono">msiexec /i 파일 /qn /norestart</span> 로 무인 설치되며, 여기 입력한 속성이 뒤에 붙습니다.</div>
        ) : (
          <div style={{ ...hint, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            예시:
            {EXE_PRESETS.map((p) => (
              <button key={p.label} type="button" className="btn btn-ghost" style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => set('install_args', p.args)}>
                {p.label} <span className="mono">{p.args}</span>
              </button>
            ))}
            <div style={{ width: '100%' }}>
              에이전트는 SYSTEM 권한으로 화면 없이 설치하므로, 무인 옵션이 없으면 설치 창이 보이지 않는 곳에서 멈췄다가 제한 시간 후 실패합니다.
            </div>
          </div>
        )}
      </div>

      <div>
        <label style={label}>설치 여부 확인용 이름</label>
        <input className="input-dark" style={{ width: '100%' }} value={m.detect_name} onChange={(e) => set('detect_name', e.target.value)} />
        <div style={hint}>PC의 '프로그램 추가/제거' 목록에서 이 글자가 들어간 항목이 있으면 설치된 것으로 봅니다.</div>
      </div>
      <div>
        <label style={label}>설치 제한 시간 (분)</label>
        <input
          className="input-dark"
          type="number"
          min={1}
          max={240}
          style={{ width: 120 }}
          value={m.timeout_min}
          onChange={(e) => set('timeout_min', parseInt(e.target.value, 10) || 30)}
        />
      </div>

      <div style={{ gridColumn: '1 / -1' }}>
        <label style={label}>삭제 명령 (선택)</label>
        <input
          className="input-dark mono"
          style={{ width: '100%' }}
          value={m.uninstall_cmd}
          onChange={(e) => set('uninstall_cmd', e.target.value)}
          placeholder='비우면 자동 (MSI 제품은 msiexec /x). 예: "C:\Program Files\App\uninstall.exe" /S'
        />
        <div style={hint}>비워 두면 MSI 로 설치된 프로그램은 자동으로 무인 삭제합니다. EXE 프로그램은 무인 삭제 명령을 직접 입력해야 할 수 있습니다.</div>
      </div>

      <div style={{ gridColumn: '1 / -1' }}>
        <label style={label}>메모</label>
        <textarea className="textarea-dark" rows={2} style={{ width: '100%' }} value={m.notes} onChange={(e) => set('notes', e.target.value)} />
      </div>

      <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 8 }}>
        <button type="submit" className="btn btn-primary" disabled={busy || !m.name.trim() || (kind === 'exe' && !m.install_args.trim())}>
          {submitLabel}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          취소
        </button>
      </div>
    </form>
  );
};
