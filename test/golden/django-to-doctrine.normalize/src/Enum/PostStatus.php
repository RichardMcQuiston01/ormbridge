<?php

declare(strict_types=1);

namespace App\Enum;

enum PostStatus: string
{
    /** Draft */
    case DRAFT = 'draft';
    /** Published */
    case PUBLISHED = 'published';
}
