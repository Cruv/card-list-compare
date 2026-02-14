import { createContext, useContext, useState, useEffect } from 'react';
import { getAppSettings } from '../lib/api';

const AppSettingsContext = createContext({ priceDisplayEnabled: true });

export function AppSettingsProvider({ children }) {
  const [settings, setSettings] = useState({ priceDisplayEnabled: true });

  useEffect(() => {
    getAppSettings()
      .then(data => setSettings({ priceDisplayEnabled: data.priceDisplayEnabled !== false }))
      .catch(() => { /* default to enabled on error */ });
  }, []);

  return (
    <AppSettingsContext.Provider value={settings}>
      {children}
    </AppSettingsContext.Provider>
  );
}

export function useAppSettings() {
  return useContext(AppSettingsContext);
}
