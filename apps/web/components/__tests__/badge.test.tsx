import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Badge } from '../shared/badge'
import type { AssetStatus } from '@/types'

describe('Badge component', () => {
  const statuses: AssetStatus[] = ['draft', 'in_review', 'in_progress', 'approved', 'rejected', 'archived']

  it.each(statuses)('renders %s status badge', (status) => {
    render(<Badge status={status} />)
    const badge = screen.getByText(/Draft|Needs Review|In Progress|Approved|Declined|Archived/)
    expect(badge).toBeInTheDocument()
  })

  it('renders "Draft" label for draft status', () => {
    render(<Badge status="draft" />)
    expect(screen.getByText('Draft')).toBeInTheDocument()
  })

  it('renders "Needs Review" label for in_review status', () => {
    render(<Badge status="in_review" />)
    expect(screen.getByText('Needs Review')).toBeInTheDocument()
  })

  it('renders "In Progress" label for in_progress status', () => {
    render(<Badge status="in_progress" />)
    expect(screen.getByText('In Progress')).toBeInTheDocument()
  })

  it('renders "Approved" label for approved status', () => {
    render(<Badge status="approved" />)
    expect(screen.getByText('Approved')).toBeInTheDocument()
  })

  it('renders "Declined" label for rejected status', () => {
    render(<Badge status="rejected" />)
    expect(screen.getByText('Declined')).toBeInTheDocument()
  })

  it('renders "Archived" label for archived status', () => {
    render(<Badge status="archived" />)
    expect(screen.getByText('Archived')).toBeInTheDocument()
  })

  it('applies custom className', () => {
    render(<Badge status="draft" className="my-custom-class" />)
    const badge = screen.getByText('Draft')
    expect(badge.className).toContain('my-custom-class')
  })
})
