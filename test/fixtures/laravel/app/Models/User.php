<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\Relations\HasOne;
use Illuminate\Foundation\Auth\User as Authenticatable;

class User extends Authenticatable
{
    protected $table = 'auth_user';

    public $timestamps = false;

    public function posts(): HasMany
    {
        return $this->hasMany(Post::class, 'author_id');
    }

    public function editedPosts(): HasMany
    {
        return $this->hasMany(Post::class, 'editor_id');
    }

    public function profile(): HasOne
    {
        return $this->hasOne(Profile::class);
    }
}
