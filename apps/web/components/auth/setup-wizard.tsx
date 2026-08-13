'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface FormState {
  email: string
  firstName: string
  lastName: string
  password: string
  confirmPassword: string
}

interface FormErrors {
  email?: string
  firstName?: string
  lastName?: string
  password?: string
  confirmPassword?: string
  general?: string
}

function validate(form: FormState): FormErrors {
  const errors: FormErrors = {}
  if (!form.email) {
    errors.email = 'Email is required'
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) {
    errors.email = 'Enter a valid email address'
  }
  // Only last name is required, matching User.last_name's NOT NULL and
  // first_name's nullable -- the same split the profile form already uses.
  if (!form.lastName.trim()) {
    errors.lastName = 'Last name is required'
  }
  if (!form.password) {
    errors.password = 'Password is required'
  } else if (form.password.length < 8) {
    errors.password = 'Password must be at least 8 characters'
  }
  if (!form.confirmPassword) {
    errors.confirmPassword = 'Please confirm your password'
  } else if (form.password !== form.confirmPassword) {
    errors.confirmPassword = 'Passwords do not match'
  }
  return errors
}

export function SetupWizard() {
  const router = useRouter()
  const [form, setForm] = useState<FormState>({
    email: '',
    firstName: '',
    lastName: '',
    password: '',
    confirmPassword: '',
  })
  const [errors, setErrors] = useState<FormErrors>({})
  const [loading, setLoading] = useState(false)
  const [success, setSuccess] = useState(false)

  function handleChange(field: keyof FormState) {
    return (e: React.ChangeEvent<HTMLInputElement>) => {
      setForm((prev) => ({ ...prev, [field]: e.target.value }))
      // Clear field error on change
      if (errors[field]) {
        setErrors((prev) => ({ ...prev, [field]: undefined }))
      }
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const validation = validate(form)
    if (Object.keys(validation).length > 0) {
      setErrors(validation)
      return
    }

    setLoading(true)
    setErrors({})
    try {
      await api.post('/setup/create-superadmin', {
        email: form.email,
        first_name: form.firstName.trim() || null,
        last_name: form.lastName.trim(),
        password: form.password,
      })
      setSuccess(true)
      setTimeout(() => {
        router.push('/login')
      }, 1800)
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors({ general: err.detail })
      } else {
        setErrors({ general: 'Something went wrong. Please try again.' })
      }
    } finally {
      setLoading(false)
    }
  }

  if (success) {
    return (
      <div className="text-center py-8 animate-fade-in">
        <div className="mb-4 mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-status-success/15">
          <svg className="h-6 w-6 text-status-success" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h2 className="text-lg font-semibold text-text-primary mb-1">Admin account created</h2>
        <p className="text-sm text-text-secondary">Redirecting you to login…</p>
      </div>
    )
  }

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-xl font-semibold text-text-primary mb-1">Welcome to FreeFrame</h1>
        <p className="text-sm text-text-secondary">
          Create the super admin account to get started. This can only be done once.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        {errors.general && (
          <div className="rounded-md border border-status-error/30 bg-status-error/10 px-3 py-2.5 text-sm text-status-error">
            {errors.general}
          </div>
        )}

        <div className="grid grid-cols-2 gap-4">
          <Input
            label="First name"
            type="text"
            placeholder="Optional"
            autoComplete="given-name"
            value={form.firstName}
            onChange={handleChange('firstName')}
            error={errors.firstName}
          />
          <Input
            label="Last name"
            type="text"
            placeholder="Required"
            autoComplete="family-name"
            value={form.lastName}
            onChange={handleChange('lastName')}
            error={errors.lastName}
          />
        </div>

        <Input
          label="Email address"
          type="email"
          placeholder="you@example.com"
          autoComplete="email"
          value={form.email}
          onChange={handleChange('email')}
          error={errors.email}
        />

        <Input
          label="Password"
          type="password"
          placeholder="Min. 8 characters"
          autoComplete="new-password"
          value={form.password}
          onChange={handleChange('password')}
          error={errors.password}
        />

        <Input
          label="Confirm password"
          type="password"
          placeholder="Repeat password"
          autoComplete="new-password"
          value={form.confirmPassword}
          onChange={handleChange('confirmPassword')}
          error={errors.confirmPassword}
        />

        <Button
          type="submit"
          size="lg"
          loading={loading}
          className="mt-2 w-full"
        >
          Create admin account
        </Button>
      </form>
    </div>
  )
}
