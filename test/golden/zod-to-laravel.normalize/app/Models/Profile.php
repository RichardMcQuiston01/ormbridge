<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class Profile extends Model
{
    public $incrementing = false;

    /** @var list<string> */
    protected $fillable = [
        'id',
        'bio',
        'avatar',
        'user_id',
    ];
}
