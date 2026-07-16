export async function fetchDopplerSecrets(
  token: string,
  project?: string,
  config?: string,
): Promise<Record<string, string>> {
  let url =
    "https://api.doppler.com/v3/configs/config/secrets/download?format=json"
  if (project && config) {
    url += `&project=${encodeURIComponent(project)}&config=${encodeURIComponent(config)}`
  }
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  })
  if (!res.ok) {
    const txt = await res.text()
    throw new Error(`Doppler API returned status ${res.status}: ${txt}`)
  }
  return res.json() as Promise<Record<string, string>>
}

type DopplerProject = {
  id: string
  name: string
}

type DopplerProjectsResponse = {
  projects?: DopplerProject[]
}

export async function fetchDopplerProjects(token: string): Promise<string[]> {
  const url = "https://api.doppler.com/v3/projects"
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  })
  if (!res.ok) {
    const txt = await res.text()
    throw new Error(`Doppler API returned status ${res.status}: ${txt}`)
  }
  const data = (await res.json()) as DopplerProjectsResponse
  return data.projects?.map(p => p.id) ?? []
}

type DopplerConfig = {
  name: string
}

type DopplerConfigsResponse = {
  configs?: DopplerConfig[]
}

export async function fetchDopplerConfigs(
  token: string,
  project: string,
): Promise<string[]> {
  const url = `https://api.doppler.com/v3/configs?project=${encodeURIComponent(project)}`
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  })
  if (!res.ok) {
    const txt = await res.text()
    throw new Error(`Doppler API returned status ${res.status}: ${txt}`)
  }
  const data = (await res.json()) as DopplerConfigsResponse
  return data.configs?.map(c => c.name) ?? []
}
