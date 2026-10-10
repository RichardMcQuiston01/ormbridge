<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\Relations\HasOne;

class BlogUser extends Model
{
    protected $table = 'blog_user';

    public $timestamps = false;

    /** @var list<string> */
    protected $fillable = [];

    /** @return HasMany<BlogPost, $this> */
    public function authorBlogPosts(): HasMany
    {
        return $this->hasMany(BlogPost::class, 'author_id');
    }

    /** @return HasMany<BlogPost, $this> */
    public function editorBlogPosts(): HasMany
    {
        return $this->hasMany(BlogPost::class, 'editor_id');
    }

    /** @return HasOne<BlogProfile, $this> */
    public function blogProfile(): HasOne
    {
        return $this->hasOne(BlogProfile::class, 'user_id');
    }
}
