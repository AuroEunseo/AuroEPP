import React, { useEffect, useState } from 'react';
import { Code2, Edit3, Plus, Trash2 } from 'lucide-react';
import { apiFetch } from '../api';
import { useConsole } from '../context/ConsoleContext';
import { REGISTRY_BLOCKS, PolicyBlockDef } from '../constants/registryBlocks';

/** 3-1. 레지스트리 정책 관리 (배포 그룹 선택·생성·이름 변경·삭제 + 정책 블록 편집) */
export const PolicyRegistryPage: React.FC = () => {
  const { state, fetchState, setLeaveGuard } = useConsole();

  // 배포 그룹(링) 선택과 편집 중인 정책 초안
  const [ringTab, setRingTabRaw] = useState('ring0');
  const [draftItems, setDraftItems] = useState<any[]>([]);
  const [loadedRing, setLoadedRing] = useState('');
  const [showRawJson, setShowRawJson] = useState(false);
  const [ringModalMode, setRingModalMode] = useState<'none' | 'create' | 'rename'>('none');
  const [ringNameInput, setRingNameInput] = useState('');

  useEffect(() => {
    if (state && state.policies[ringTab] && loadedRing !== ringTab) {
      setDraftItems(JSON.parse(JSON.stringify(state.policies[ringTab].items || [])));
      setLoadedRing(ringTab);
    }
  }, [state, ringTab, loadedRing]);

  // 저장하지 않은 변경 감지 → 다른 메뉴로 이동하거나 다른 배포 그룹을 고를 때 확인 창
  const savedItems = state.policies[ringTab]?.items || [];
  const isDirty = loadedRing === ringTab && JSON.stringify(draftItems) !== JSON.stringify(savedItems);
  const confirmDiscard = () =>
    !isDirty || window.confirm(`[${ringTab}] 정책에 저장하지 않은 변경이 있습니다.\n저장하지 않고 이동할까요?`);

  useEffect(() => {
    setLeaveGuard(isDirty ? confirmDiscard : null);
    return () => setLeaveGuard(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDirty, ringTab]);

  const setRingTab = (next: string) => {
    if (next !== ringTab && !confirmDiscard()) return;
    setRingTabRaw(next);
  };

  // 레지스트리 블록 조작 헬퍼
  const getItemValue = (path: string, name: string) =>
    draftItems.find((x) => x.path === path && x.name === name)?.value;

  const setItemValue = (path: string, name: string, type: 'DWORD' | 'SZ', value: number | string) => {
    setDraftItems((prev) => {
      const next = [...prev];
      const idx = next.findIndex((x) => x.path === path && x.name === name);
      if (idx >= 0) {
        next[idx] = { ...next[idx], type, value };
      } else {
        next.push({ path, name, type, value });
      }
      return next;
    });
  };

  // 서버가 내려주는 기능 업데이트 고정 버전 기본값 (AURORA_TARGET_RELEASE)
  const defaultTargetRelease = state?.defaults?.target_release || '25H2';

  const toggleBlock = (blk: PolicyBlockDef, enable: boolean) => {
    setItemValue(blk.path, blk.name, blk.type, enable ? blk.enabledValue : blk.disabledValue);
    if (enable && blk.hasParam === 'days' && getItemValue(blk.path, blk.paramName!) === undefined) {
      setItemValue(blk.path, blk.paramName!, 'DWORD', 7);
    }
    if (enable && blk.hasParam === 'version') {
      setItemValue(blk.path, 'ProductVersion', 'SZ', 'Windows 11');
      if (!getItemValue(blk.path, blk.paramName!)) {
        setItemValue(blk.path, blk.paramName!, 'SZ', defaultTargetRelease);
      }
    }
  };

  const savePolicyBlocks = async () => {
    await apiFetch('/policies', { ring: ringTab, items: draftItems });
    // 저장된 최신 정책을 먼저 받아온 뒤 초안을 다시 불러온다.
    // (이전에는 갱신 전 상태로 초안을 다시 읽어 화면이 저장 전 값으로 되돌아가는 문제가 있었음)
    await fetchState();
    setLoadedRing('');
  };

  const handleRingSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = ringNameInput.trim();
    if (!trimmed) return;
    try {
      if (ringModalMode === 'create') {
        await apiFetch('/rings', { ring: trimmed, copy_from: ringTab });
      } else if (ringModalMode === 'rename') {
        await apiFetch(`/rings/${encodeURIComponent(ringTab)}`, { new_ring: trimmed }, 'PUT');
      }
      setRingTab(trimmed);
      setLoadedRing('');
      setRingNameInput('');
      setRingModalMode('none');
      fetchState();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleDeleteRing = async () => {
    if (ringTab === 'ring0' || ringTab === 'ring1') {
      return alert('기본 배포 그룹(ring0, ring1)은 삭제할 수 없습니다.');
    }
    if (
      !confirm(
        `[${ringTab}] 배포 그룹을 삭제하시겠습니까?\n이 그룹에 배정되어 있던 PC는 자동으로 ring1으로 이동됩니다.`
      )
    ) {
      return;
    }
    try {
      await apiFetch(`/rings/${encodeURIComponent(ringTab)}`, undefined, 'DELETE');
      setRingTab('ring1');
      setLoadedRing('');
      fetchState();
    } catch (err: any) {
      alert(err.message);
    }
  };

  return (
    <>
      <div className="page-header">
        <div>
          <h2 className="page-title">레지스트리 정책 관리</h2>
          <p className="page-desc">
            드롭다운에서 배포 그룹(Ring)을 선택하거나 이름 변경·신규 생성 후 각 정책 블록을 활성화하세요.
          </p>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          <select
            value={ringTab}
            onChange={(e) => {
              setRingTab(e.target.value);
              setLoadedRing('');
              setRingModalMode('none');
            }}
            className="select-dark mono"
            style={{ minWidth: 160, fontWeight: 700 }}
          >
            {Object.keys(state.policies).map((r) => (
              <option key={r} value={r}>
                배포 그룹: {r}
              </option>
            ))}
          </select>

          {ringModalMode === 'none' ? (
            <>
              <button
                onClick={() => {
                  setRingNameInput(ringTab);
                  setRingModalMode('rename');
                }}
                className="btn btn-ghost"
              >
                <Edit3 size={13} /> 이름 변경
              </button>
              <button
                onClick={() => {
                  setRingNameInput('');
                  setRingModalMode('create');
                }}
                className="btn btn-ghost"
              >
                <Plus size={14} style={{ color: 'var(--accent-text)' }} /> 그룹 추가
              </button>
              {ringTab !== 'ring0' && ringTab !== 'ring1' && (
                <button onClick={handleDeleteRing} className="btn btn-rose">
                  <Trash2 size={13} /> 삭제
                </button>
              )}
            </>
          ) : (
            <form onSubmit={handleRingSubmit} style={{ display: 'flex', gap: 6 }}>
              <input
                value={ringNameInput}
                onChange={(e) => setRingNameInput(e.target.value)}
                placeholder={ringModalMode === 'create' ? '새 그룹 이름 입력' : '변경할 이름 입력'}
                className="input-dark"
                style={{ width: 160 }}
                autoFocus
              />
              <button type="submit" className="btn btn-emerald">
                {ringModalMode === 'create' ? '생성' : '변경 저장'}
              </button>
              <button
                type="button"
                onClick={() => setRingModalMode('none')}
                className="btn btn-ghost"
              >
                취소
              </button>
            </form>
          )}

          <button onClick={() => setShowRawJson((v) => !v)} className="btn btn-ghost">
            <Code2 size={14} /> {showRawJson ? '기능 블록 보기' : '원본 JSON'}
          </button>
          <button onClick={savePolicyBlocks} className="btn btn-primary">
            정책 저장 및 즉시 배포
          </button>
        </div>
      </div>

      {!showRawJson ? (
        <div className="policy-blocks-grid">
          {REGISTRY_BLOCKS.map((blk) => {
            const curVal = getItemValue(blk.path, blk.name);
            const isEnabled = curVal === blk.enabledValue;

            return (
              <div key={blk.id} className={`policy-block ${isEnabled ? 'enabled' : ''}`}>
                <div>
                  <div className="policy-block-top">
                    <h3 className="policy-block-title">{blk.title}</h3>
                    <div className="toggle-pill">
                      <button
                        type="button"
                        className={`toggle-opt ${isEnabled ? 'on' : ''}`}
                        onClick={() => toggleBlock(blk, true)}
                      >
                        활성화
                      </button>
                      <button
                        type="button"
                        className={`toggle-opt ${!isEnabled ? 'off' : ''}`}
                        onClick={() => toggleBlock(blk, false)}
                      >
                        비활성화
                      </button>
                    </div>
                  </div>
                  <p className="policy-block-desc">{blk.desc}</p>
                </div>

                {isEnabled && blk.hasParam === 'days' && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                    <span>지연 기간(일):</span>
                    <input
                      type="number"
                      min={0}
                      max={365}
                      value={Number(getItemValue(blk.path, blk.paramName!) ?? 7)}
                      onChange={(e) =>
                        setItemValue(blk.path, blk.paramName!, 'DWORD', parseInt(e.target.value, 10) || 0)
                      }
                      className="input-dark mono"
                      style={{ width: 84 }}
                    />
                    <span style={{ color: 'var(--text-secondary)' }}>일 후 설치 허용</span>
                  </div>
                )}

                {isEnabled && blk.hasParam === 'version' && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                    <span>목표 빌드 버전:</span>
                    <input
                      type="text"
                      value={String(getItemValue(blk.path, blk.paramName!) ?? defaultTargetRelease)}
                      onChange={(e) => {
                        setItemValue(blk.path, 'ProductVersion', 'SZ', 'Windows 11');
                        setItemValue(blk.path, blk.paramName!, 'SZ', e.target.value.trim());
                      }}
                      placeholder={`예: ${defaultTargetRelease}`}
                      className="input-dark mono"
                      style={{ width: 110 }}
                    />
                  </div>
                )}

                <div className="policy-block-meta mono">
                  HKLM\{blk.path}\{blk.name} = {curVal !== undefined ? String(curVal) : '미설정(0)'}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <section className="glass-card panel">
          <textarea
            value={JSON.stringify(draftItems, null, 2)}
            onChange={(e) => {
              try {
                setDraftItems(JSON.parse(e.target.value));
              } catch {}
            }}
            spellCheck={false}
            className="textarea-dark mono"
            style={{ minHeight: 360 }}
          />
        </section>
      )}
    </>
  );
};
