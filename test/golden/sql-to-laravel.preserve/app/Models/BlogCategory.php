<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

class BlogCategory extends Model
{
    protected $table = 'blog_category';

    /** @var list<string> */
    protected $fillable = [
        'name',
        'slug',
        'parent_id',
    ];

    /** @return BelongsTo<BlogCategory, $this> */
    public function parent(): BelongsTo
    {
        return $this->belongsTo(BlogCategory::class);
    }

    /** @return HasMany<BlogCategory, $this> */
    public function blogCategories(): HasMany
    {
        return $this->hasMany(BlogCategory::class, 'parent_id');
    }

    /** @return HasMany<BlogPost, $this> */
    public function blogPosts(): HasMany
    {
        return $this->hasMany(BlogPost::class, 'category_id');
    }
}
