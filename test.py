import requests
import json

url = "https://spicy-api.glyph-labs.site/api/dashboard"
response = requests.get(url)
data = response.json()

print("Глобальные ключи в ответе:", list(data.keys()))

if "users" in data and len(data["users"]) > 0:
    print("\nКлючи первого пользователя:", list(data["users"][0].keys()))
    print("\nСам первый пользователь:")
    print(json.dumps(data["users"][0], indent=2))
else:
    print("\nМассив 'users' пуст или отсутствует.")