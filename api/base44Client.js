const BASE_URL = 'https://base44.app/api';
const APP_ID = '69e27cfb0f37443a073af5db';
const API_KEY = 'c346575bc64b432ba9f0c78790cd631d';

const headers = {
  'Content-Type': 'application/json',
  'api_key': API_KEY,
};

export async function fetchEntities(entityName) {
  const response = await fetch(`${BASE_URL}/apps/${APP_ID}/entities/${entityName}`, { headers });
  const data = await response.json();
  return { status: response.status, data };
}

export async function testConnection() {
  const response = await fetch(`${BASE_URL}/apps/${APP_ID}/entities/Course`, { headers });
  const data = await response.json();
  return { status: response.status, data };
}
