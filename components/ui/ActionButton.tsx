'use client'

import { ButtonHTMLAttributes, ReactNode } from 'react'

interface ActionButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost'
  children: ReactNode
}

export default function ActionButton({ variant = 'primary', children, className = '', style, ...props }: ActionButtonProps) {
  const variantClass = variant === 'primary'
    ? 'btn-primary'
    : variant === 'secondary'
    ? 'btn-secondary'
    : 'btn-ghost'

  return (
    <button className={`${variantClass} ${className}`} style={style} {...props}>
      {children}
    </button>
  )
}
