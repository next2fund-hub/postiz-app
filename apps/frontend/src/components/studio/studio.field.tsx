'use client';

import { FC } from 'react';
import { useFormContext } from 'react-hook-form';
import { Input } from '@gitroom/react/form/input';
import { Textarea } from '@gitroom/react/form/textarea';
import { Select } from '@gitroom/react/form/select';
import { Checkbox } from '@gitroom/react/form/checkbox';
import { MultiMediaComponent } from '@gitroom/frontend/components/media/media.component';

/** Mirrors StudioParamField in the backend catalog. */
export interface StudioFieldSpec {
  name: string;
  label: string;
  type: 'text' | 'textarea' | 'select' | 'number' | 'boolean' | 'media';
  description?: string;
  required?: boolean;
  maxLength?: number;
  placeholder?: string;
  default?: any;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  accept?: 'image' | 'video';
}

/**
 * Renders one catalog field.
 *
 * This is the piece that makes the catalog worth having: the server describes
 * a model's inputs, and the form builds itself. No per-model React component,
 * which is what the old videos/ registry required.
 */
export const StudioField: FC<{ field: StudioFieldSpec }> = ({ field }) => {
  const { register, watch, setValue, formState } = useFormContext();
  const error = formState?.errors?.[field.name]?.message as string | undefined;

  if (field.type === 'media') {
    const value = watch(field.name) || [];
    return (
      <div className="flex flex-col gap-[6px]">
        <div className="text-[14px]">
          {field.label}
          {field.required && <span className="text-red-400"> *</span>}
        </div>
        {field.description && (
          <div className="text-[12px] text-textItemBlur">{field.description}</div>
        )}
        <MultiMediaComponent
          allData={[]}
          dummy={true}
          text={field.label}
          description={field.description || field.label}
          name={field.name}
          label={field.label}
          value={value}
          error={error}
          onChange={(e) => {
            const picked = (e.target.value || []).filter((m: any) =>
              field.accept === 'image' ? m.path?.indexOf('mp4') === -1 : true
            );
            setValue(field.name, picked.slice(0, field.max ?? picked.length));
          }}
        />
      </div>
    );
  }

  if (field.type === 'boolean') {
    return (
      <Checkbox
        name={field.name}
        label={field.label}
        onChange={(e) => setValue(field.name, e.target.value)}
      />
    );
  }

  if (field.type === 'select') {
    return (
      <Select
        label={field.label}
        error={error}
        {...register(field.name, { value: field.default })}
      >
        {(field.options || []).map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
    );
  }

  if (field.type === 'textarea') {
    return (
      <Textarea
        label={field.label}
        placeholder={field.placeholder}
        error={error}
        {...register(field.name, {
          required: field.required ? `${field.label} is required` : false,
          maxLength: field.maxLength
            ? {
                value: field.maxLength,
                message: `${field.label} must be ${field.maxLength} characters or fewer`,
              }
            : undefined,
          value: field.default,
        })}
      />
    );
  }

  return (
    <Input
      label={field.label}
      type={field.type === 'number' ? 'number' : 'text'}
      placeholder={field.placeholder}
      error={error}
      {...register(field.name, {
        required: field.required ? `${field.label} is required` : false,
        value: field.default,
      })}
    />
  );
};
