 
## Endpoints adicionados (somente leitura)
- **GET `/api/me/reservations`** (auth) → lista reservas do usuário logado
- **GET `/api/admin/reservations`** (auth + admin) → lista/pagina reservas com filtros
- **GET `/api/draws/:id/numbers`** → alias para leitura de números por sorteio
 
### Testes rápidos (curl)
```bash
# Minha área 
curl -s http://localhost:4000/api/me/reservations -H "Authorization: Bearer $TOKEN" | jq .

# Admin
curl -s "http://localhost:4000/api/admin/reservations?page=1&pageSize=20&status=active"     -H "Authorization: Bearer $TOKEN" | jq .

# Números por sorteio
curl -s http://localhost:4000/api/draws/1/numbers | jq .

# Conflito (esperado 409 permanece inalterado)
curl -i -s -X POST http://localhost:4000/api/reservations     -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json"     -d '{"numbers":[10]}'
```
