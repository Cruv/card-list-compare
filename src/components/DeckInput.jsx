import { useRef, useState } from 'react';
import { fetchDeckFromUrl } from '../lib/fetcher';
import NameModal from './NameModal';
import './DeckInput.css';

const PLACEHOLDER = `Paste your deck list here...

Supported formats:
4 Lightning Bolt
4x Lightning Bolt
4 Lightning Bolt (M10) 123
CSV with header row

Separate sideboard with a blank line
or a "Sideboard" header.`;

export default function DeckInput({ label, value, onChange, snapshots, onLoadSnapshot, onSaveSnapshot }) {
  const fileRef = useRef(null);
  const [urlInput, setUrlInput] = useState('');
  const [showUrl, setShowUrl] = useState(false);
  const [showSnapshots, setShowSnapshots] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [showNameModal, setShowNameModal] = useState(false);

  function handleFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      onChange(ev.target.result);
      setError(null);
    };
    reader.onerror = () => {
      setError('Failed to read file. Please try again.');
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  async function handleUrlImport() {
    if (!urlInput.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const { text } = await fetchDeckFromUrl(urlInput.trim());
      onChange(text);
      setShowUrl(false);
      setUrlInput('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function handleUrlKeyDown(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleUrlImport();
    }
    if (e.key === 'Escape') {
      setShowUrl(false);
      setError(null);
    }
  }

  function handleSave() {
    if (!value.trim()) return;
    setShowNameModal(true);
  }

  return (
    <div className="deck-input">
      <div className="deck-input-header">
        <label className="deck-input-label">{label}</label>
        <div className="deck-input-actions">
          <button
            className={`deck-input-btn${showUrl ? ' deck-input-btn--active' : ''}`}
            onClick={() => { setShowUrl(!showUrl); setShowSnapshots(false); setError(null); }}
            type="button"
            title="Import from URL"
          >
            URL
          </button>
          <button
            className={`deck-input-btn${showSnapshots ? ' deck-input-btn--active' : ''}`}
            onClick={() => { setShowSnapshots(!showSnapshots); setShowUrl(false); setError(null); }}
            type="button"
            title="Load a saved snapshot"
          >
            Snapshots
          </button>
          <button
            className="deck-input-btn"
            onClick={handleSave}
            disabled={!value.trim()}
            type="button"
            title="Save current list as snapshot"
          >
            Save
          </button>
          <button
            className="deck-input-btn"
            onClick={() => fileRef.current?.click()}
            type="button"
            title="Upload a file"
          >
            File
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".txt,.csv,.dec,.dek,.mwDeck"
            onChange={handleFile}
            hidden
          />
        </div>
      </div>

      {showUrl && (
        <div className="deck-input-url-bar">
          <input
            className="deck-input-url"
            type="url"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={handleUrlKeyDown}
            placeholder="Paste Archidekt or Moxfield URL..."
            autoFocus
            disabled={loading}
          />
          <button
            className="deck-input-url-go"
            onClick={handleUrlImport}
            disabled={loading || !urlInput.trim()}
            type="button"
          >
            {loading ? 'Loading...' : 'Import'}
          </button>
        </div>
      )}

      {showSnapshots && (
        <div className="deck-input-snapshots">
          {snapshots.length === 0 ? (
            <p className="deck-input-snapshots-empty">No saved snapshots yet.</p>
          ) : (
            <ul className="deck-input-snapshots-list">
              {snapshots.map((snap) => (
                <li key={snap.id} className="deck-input-snapshot-item">
                  <button
                    className="deck-input-snapshot-btn"
                    onClick={() => {
                      onLoadSnapshot(snap);
                      setShowSnapshots(false);
                    }}
                    type="button"
                  >
                    <span className="snapshot-name">{snap.name}</span>
                    <span className="snapshot-meta">
                      {snap.source !== 'paste' && <span className="snapshot-source">{snap.source}</span>}
                      {new Date(snap.createdAt).toLocaleDateString()}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {error && (
        <div className="deck-input-error" role="alert">
          {error.split('\n').map((line, i) => (
            <span key={i}>{line}<br /></span>
          ))}
        </div>
      )}

      <textarea
        className="deck-input-textarea"
        value={value}
        onChange={(e) => { onChange(e.target.value); setError(null); }}
        placeholder={PLACEHOLDER}
        spellCheck={false}
        aria-label={`${label} deck list`}
      />

      {showNameModal && (
        <NameModal
          defaultValue={`${label} - ${new Date().toLocaleDateString()}`}
          title="Save Snapshot"
          placeholder="Snapshot name..."
          onConfirm={(name) => {
            onSaveSnapshot(name, value);
            setShowNameModal(false);
          }}
          onCancel={() => setShowNameModal(false)}
        />
      )}
    </div>
  );
}
