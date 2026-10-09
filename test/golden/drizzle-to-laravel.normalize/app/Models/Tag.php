<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

class Tag extends Model
{
    /** @var list<string> */
    protected $fillable = [
        'label',
    ];

    /** @return HasMany<PostTag, $this> */
    public function posts(): HasMany
    {
        return $this->hasMany(PostTag::class);
    }
}
