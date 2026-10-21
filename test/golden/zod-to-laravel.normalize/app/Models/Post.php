<?php

declare(strict_types=1);

namespace App\Models;

use App\Enums\PostStatus;
use Illuminate\Database\Eloquent\Model;

class Post extends Model
{
    public $incrementing = false;

    /** @var list<string> */
    protected $fillable = [
        'id',
        'public_id',
        'title',
        'body',
        'status',
        'rating',
        'view_count',
        'is_featured',
        'published_at',
        'metadata',
        'author_id',
        'editor_id',
        'category_id',
    ];

    /** @var array<string, string> */
    protected $casts = [
        'status' => PostStatus::class,
        'rating' => 'decimal:2',
        'is_featured' => 'boolean',
        'published_at' => 'datetime',
        'metadata' => 'array',
    ];
}
