<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

class Tag extends Model
{
    protected $table = 'blog_tag';

    public $timestamps = false;

    /** @var list<string> */
    protected $fillable = [
        'label',
    ];

    /** @return HasMany<PostTags, $this> */
    public function posts(): HasMany
    {
        return $this->hasMany(PostTags::class);
    }
}
