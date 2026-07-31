import { expect, test } from '@playwright/test'
import {
  currentTotp,
  enrollMfaViaApi,
  registerAndLoginViaApi,
  waitForNextTotpWindow,
} from '../fixtures/auth.js'
import { uniqueEmail, uniqueOrgName } from '../fixtures/ids.js'

const spanishSignIn = 'Iniciar sesión'

test.describe('J8 — pre-authentication localization', () => {
  test('localizes the registration shell and preserves typed values at a narrow viewport', async ({
    page,
  }) => {
    const registerPassword = ['e2e', 'J8', 'Register', 'Password', '123'].join('-')
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto('/register')

    await page.getByLabel('Email').fill(uniqueEmail('j8-register'))
    await page.getByLabel('Organization name').fill(uniqueOrgName('J8 Register'))
    await page.getByLabel('Password').fill(registerPassword)
    await page.getByRole('button', { name: 'Español' }).click()

    await expect(page).toHaveTitle('Registrarse | Project Vault')
    await expect(page.getByRole('heading', { name: 'Registrarse' })).toBeVisible()
    await expect(
      page.getByText('Crea una organización independiente nueva en este vault.')
    ).toBeVisible()
    await expect(page.getByRole('link', { name: spanishSignIn })).toBeVisible()
    await expect(page.getByLabel('Correo electrónico')).toHaveValue(/j8-register/)
    await expect(page.getByLabel('Nombre de la organización')).toHaveValue(/J8 Register/)
    await expect(page.getByLabel('Contraseña')).toHaveValue(registerPassword)
  })

  test('localizes the real MFA challenge and invalid-code feedback after a locale switch', async ({
    page,
    context,
  }) => {
    const email = uniqueEmail('j8-mfa')
    const password = ['e2e', 'J8', 'Mfa', 'Password', '123'].join('-')
    await registerAndLoginViaApi(context, { email, password, orgName: uniqueOrgName('J8 MFA') })
    const { secret } = await enrollMfaViaApi(context)
    await context.clearCookies()

    await page.goto('/login')
    await page.getByRole('button', { name: 'Español' }).click()
    await expect(page).toHaveTitle('Iniciar sesión | Project Vault')
    await expect(page.getByRole('heading', { name: spanishSignIn })).toBeVisible()

    await page.getByLabel('Correo electrónico').fill(email)
    await page.getByRole('button', { name: 'Continuar' }).click()
    await page.getByLabel('Contraseña').fill(password)
    await page.getByRole('button', { name: 'Iniciar sesión' }).click()
    await expect(page.getByLabel('Código del autenticador')).toBeVisible()
    await expect(
      page.getByText('Introduce el código de seis dígitos de tu aplicación autenticadora.')
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'Verificar código MFA' })).toBeVisible()

    await waitForNextTotpWindow()
    const validCode = currentTotp(secret)
    const lastDigit = Number(validCode[validCode.length - 1])
    const wrongCode = validCode.slice(0, -1) + String((lastDigit + 1) % 10)
    await page.getByLabel('Código del autenticador').fill(wrongCode)
    await page.getByRole('button', { name: 'Verificar código MFA' }).click()
    await expect(page.getByRole('alert')).toHaveText(
      'Ese código no fue aceptado. Prueba el siguiente código de tu autenticador.'
    )
  })
})
